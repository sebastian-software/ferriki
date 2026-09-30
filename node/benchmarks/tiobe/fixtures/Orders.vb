Imports System
Imports System.Collections.Generic
Imports System.Linq

' Visual Basic .NET: aggregate completed orders with Decimal amounts.
Public Class Order
    Public Property Customer As String
    Public Property Amount As Decimal
    Public Property Completed As Boolean = True
End Class

Module Orders
    Function Summarize(values As IEnumerable(Of Order)) As Dictionary(Of String, Decimal)
        Return values.Where(Function(o) o.Completed AndAlso o.Amount >= 0D) _
            .GroupBy(Function(o) o.Customer) _
            .ToDictionary(Function(g) g.Key, Function(g) g.Sum(Function(o) o.Amount))
    End Function

    Sub Main()
        Dim values As New List(Of Order) From {
            New Order With {.Customer = "Ada", .Amount = 19.95D},
            New Order With {.Customer = "Zoë", .Amount = 12.50D},
            New Order With {.Customer = "Ada", .Amount = 5D, .Completed = False}
        }
        For Each entry In Summarize(values)
            Dim label = $"<total customer=""{entry.Key}"">€{entry.Value:F2}</total>"
            Console.WriteLine(label)
        Next
    End Sub
End Module
